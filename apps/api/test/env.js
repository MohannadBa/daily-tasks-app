// Environment for integration tests. Uses the dailytasks_test DB in the compose Postgres (host port 5433).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://dailytasks:dailytasks@localhost:5433/dailytasks_test?schema=public';
process.env.AUTH_MODE = 'local';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.S3_BUCKET = 'test-bucket';
process.env.SQS_EVENTS_QUEUE_URL = 'http://localhost:4566/000000000000/test';
process.env.SWAGGER_ENABLED = 'false';
process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'BMW1eav9vRcXwjakWQGhbeHneaQ6NiDCI-GNmK_LI3EcGGlxknRwdVxgjOvKKQSXcZDOZb9QN5g56IgICPtAT5o';
