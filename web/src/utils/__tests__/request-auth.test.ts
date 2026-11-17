import storage, { redirectToLogin } from '../authorization-util';
import notification from '../notification';
import { handleRejectedSession } from '../request-auth';

jest.mock('@/locales/config', () => ({ t: () => 'Sign in again' }));
jest.mock('../authorization-util', () => ({
  ...jest.requireActual('../authorization-util'),
  __esModule: true,
  redirectToLogin: jest.fn(),
}));
jest.mock('../notification', () => ({
  error: jest.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

test('an expired session produces one prompt and redirect across requests', () => {
  storage.setAuthorization('current-session');

  handleRejectedSession('current-session');
  handleRejectedSession('current-session');

  expect(storage.getAuthorization()).toBe('');
  expect(notification.error).toHaveBeenCalledTimes(1);
  expect(redirectToLogin).toHaveBeenCalledTimes(1);
});

test('stale and unauthenticated responses preserve the current session', () => {
  storage.setAuthorization('new-session');

  handleRejectedSession('old-session');
  handleRejectedSession(null);
  handleRejectedSession(['new-session']);
  handleRejectedSession(true);
  handleRejectedSession(401);

  expect(storage.getAuthorization()).toBe('new-session');
  expect(notification.error).not.toHaveBeenCalled();
  expect(redirectToLogin).not.toHaveBeenCalled();
});
