import { configure } from '@testing-library/react-native';

/** findBy and waitFor wait up to 10 s (default 1 s): slow CI runners, not slow screens. */
configure({ asyncUtilTimeout: 10000 });
