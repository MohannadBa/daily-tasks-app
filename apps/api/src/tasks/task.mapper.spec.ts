import { isOverdue } from './task.mapper';

describe('isOverdue', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  it('is true for open tasks past the deadline', () => {
    expect(isOverdue({ status: 'ASSIGNED', deadline: new Date('2030-01-01T11:00:00Z') }, now)).toBe(true);
    expect(isOverdue({ status: 'IN_PROGRESS', deadline: new Date('2030-01-01T11:59:59Z') }, now)).toBe(true);
  });
  it('is never true for completed tasks', () => {
    expect(isOverdue({ status: 'COMPLETED', deadline: new Date('2020-01-01T00:00:00Z') }, now)).toBe(false);
  });
  it('is false before the deadline', () => {
    expect(isOverdue({ status: 'ASSIGNED', deadline: new Date('2030-01-02T00:00:00Z') }, now)).toBe(false);
  });
});
