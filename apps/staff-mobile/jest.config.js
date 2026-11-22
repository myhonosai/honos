/** Jest for the staff app. @hon/contracts is read from source, the same files the API and web use. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  moduleNameMapper: {
    '^@hon/contracts/(.*)$': '<rootDir>/../../packages/contracts/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Contracts sources live outside this app; Babel helpers they need come from this app's node_modules.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
};
