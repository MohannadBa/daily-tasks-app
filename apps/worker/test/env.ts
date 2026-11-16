process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://dailytasks:dailytasks@localhost:5433/dailytasks_test?schema=public';
process.env.LOG_LEVEL = 'error';
export {};
