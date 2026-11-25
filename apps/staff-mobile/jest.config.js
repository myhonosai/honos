/** Jest for the staff app. @hon/contracts is read from source, the same files the API and web use. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  // CI runners are slow on a cold start (the first render of each file can take several seconds). A test that
  // times out keeps running and its later presses land on the next test's screen, so give both the test and
  // every findBy/waitFor room instead of failing the next test with duplicates.
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^@hon/contracts/(.*)$': '<rootDir>/../../packages/contracts/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Contracts sources live outside this app; Babel helpers they need come from this app's node_modules.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
};
