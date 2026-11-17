import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  ConfirmForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { ApiEnv } from '@dailytasks/config';
import { IdentityService } from './identity.service';

/**
 * CONTRACT tests for the Cognito code paths with a stubbed Cognito client: they pin which Cognito
 * API calls are made, with which parameters, and what is written to our database. They do NOT
 * verify Cognito itself (e-mail delivery, password policy, token revocation) — that requires the
 * staging user pool (docs/COGNITO_TESTS.md).
 */
const env = { AUTH_MODE: 'cognito', AWS_REGION: 'eu-north-1', COGNITO_USER_POOL_ID: 'pool-1', COGNITO_CLIENT_ID: 'client-1' } as unknown as ApiEnv;
const EMAIL = 'nora@example.com';
const user = { id: 'u1', companyId: 'c1', email: EMAIL, isActive: true, mustChangePassword: true };

function setup(respond: (cmd: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue(user) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const tokens = { verifyAccessToken: jest.fn().mockResolvedValue({ subject: 'sub-1', mode: 'cognito' }) };
  const svc = new IdentityService(env, prisma as never, tokens as never);
  (svc as unknown as { cognito: { send: (c: unknown) => Promise<unknown> } }).cognito = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      const r = respond(cmd);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { svc, prisma, sent };
}
const named = (name: string) => Object.assign(new Error(name), { name });

describe('IdentityService — Cognito contract (stubbed client)', () => {
  it('admin-created account (default EMAIL delivery): Cognito generates and e-mails the temporary password; we never see it', async () => {
    const { svc, sent } = setup();
    const r = await svc.provisionUser(EMAIL, 'EMAIL');
    expect(r).toEqual({ reveal: undefined });
    const cmd = sent[0] as AdminCreateUserCommand;
    expect(cmd).toBeInstanceOf(AdminCreateUserCommand);
    expect(cmd.input).toMatchObject({ UserPoolId: 'pool-1', Username: EMAIL, DesiredDeliveryMediums: ['EMAIL'] });
    expect(cmd.input.TemporaryPassword).toBeUndefined();
    expect(cmd.input.MessageAction).toBeUndefined();
  });

  it('SHOW_ONCE: a generated temporary password is set in Cognito, the e-mail suppressed, and returned once', async () => {
    const { svc, sent } = setup();
    const r = await svc.provisionUser(EMAIL, 'SHOW_ONCE');
    const cmd = sent[0] as AdminCreateUserCommand;
    expect(cmd.input.MessageAction).toBe('SUPPRESS');
    expect(cmd.input.TemporaryPassword).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(r.reveal).toBe(cmd.input.TemporaryPassword);
  });

  it('first login with the temporary password returns the NEW_PASSWORD_REQUIRED challenge and no tokens', async () => {
    const { svc } = setup(() => ({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1' }));
    await expect(svc.login(EMAIL, 'Temp')).resolves.toEqual({ status: 'NEW_PASSWORD_REQUIRED', session: 'sess-1', email: EMAIL });
  });

  it('completing the challenge links the Cognito identity, clears mustChangePassword and audits', async () => {
    const { svc, prisma, sent } = setup((cmd) => (cmd instanceof RespondToAuthChallengeCommand ? { AuthenticationResult: { AccessToken: 'at', RefreshToken: 'rt', ExpiresIn: 3600 } } : {}));
    const r = await svc.completeNewPassword(EMAIL, 'sess-1', 'Newpass2030');
    expect(r).toMatchObject({ status: 'OK', userId: 'u1', tokens: { accessToken: 'at', refreshToken: 'rt' } });
    expect((sent[0] as RespondToAuthChallengeCommand).input).toMatchObject({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1', ChallengeResponses: { USERNAME: EMAIL, NEW_PASSWORD: 'Newpass2030' } });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cognitoSub: 'sub-1' }) }));
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: false }) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PASSWORD_CHANGED' }) }));
  });

  it('a wrong password / rejected login maps to a generic 401 (no account-state leak)', async () => {
    for (const err of ['NotAuthorizedException', 'UserNotFoundException', 'PasswordResetRequiredException', 'UserNotConfirmedException']) {
      const { svc } = setup(() => named(err));
      await expect(svc.login(EMAIL, 'bad')).rejects.toMatchObject({ status: 401, message: 'Invalid email or password' });
    }
  });

  it('inactive or unknown users are refused before Cognito is called', async () => {
    const { svc, prisma, sent } = setup();
    prisma.user.findUnique.mockResolvedValueOnce({ ...user, isActive: false });
    await expect(svc.login(EMAIL, 'x')).rejects.toMatchObject({ status: 401 });
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(svc.login(EMAIL, 'x')).rejects.toMatchObject({ status: 401 });
    expect(sent).toHaveLength(0);
  });

  it('normal login after the password change returns tokens', async () => {
    const { svc, sent } = setup(() => ({ AuthenticationResult: { AccessToken: 'at2', RefreshToken: 'rt2', ExpiresIn: 3600 } }));
    await expect(svc.login(EMAIL, 'Newpass2030')).resolves.toMatchObject({ status: 'OK', tokens: { accessToken: 'at2' } });
    expect((sent[0] as InitiateAuthCommand).input).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client-1' });
  });

  it('admin reset: EMAIL → AdminResetUserPassword; SHOW_ONCE → AdminSetUserPassword(Permanent=false) returned once', async () => {
    const a = setup();
    await expect(a.svc.adminResetPassword(EMAIL, 'EMAIL')).resolves.toEqual({ mode: 'email' });
    expect(a.sent[0]).toBeInstanceOf(AdminResetUserPasswordCommand);
    const b = setup();
    const r = await b.svc.adminResetPassword(EMAIL, 'SHOW_ONCE');
    const cmd = b.sent[0] as AdminSetUserPasswordCommand;
    expect(cmd).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(cmd.input).toMatchObject({ Username: EMAIL, Permanent: false });
    expect(r.reveal).toBe(cmd.input.Password);
  });

  it('completing an e-mailed reset code clears mustChangePassword (no second forced change) and audits', async () => {
    const { svc, prisma, sent } = setup();
    await svc.confirmPasswordReset(EMAIL, '123456', 'Newpass2031');
    expect(sent[0]).toBeInstanceOf(ConfirmForgotPasswordCommand);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: false }) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: { via: 'reset-code' } }) }));
  });

  it('a bad reset code changes nothing', async () => {
    const { svc, prisma } = setup(() => named('CodeMismatchException'));
    await expect(svc.confirmPasswordReset(EMAIL, '000000', 'Newpass2031')).rejects.toMatchObject({ status: 400 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('global sign-out and deactivation use the admin APIs on the right user', async () => {
    const { svc, sent } = setup();
    await svc.signOutEverywhere(EMAIL);
    await svc.setUserEnabled(EMAIL, false);
    expect(sent[0]).toBeInstanceOf(AdminUserGlobalSignOutCommand);
    expect((sent[0] as AdminUserGlobalSignOutCommand).input).toEqual({ UserPoolId: 'pool-1', Username: EMAIL });
    expect(sent[1]).toBeInstanceOf(AdminDisableUserCommand);
  });

  it('forgot-password never reveals whether the account exists', async () => {
    const { svc, prisma, sent } = setup(() => named('UserNotFoundException'));
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(svc.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    await expect(svc.forgotPassword(EMAIL)).resolves.toBeUndefined(); // Cognito error swallowed
  });
});
