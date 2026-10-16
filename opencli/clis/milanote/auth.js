import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../../node_modules/@jackwener/opencli/clis/_shared/site-auth.js';
import { DOMAIN, ensureSession } from './session.js';

async function identity(page) {
  const session = await ensureSession(page);
  return {
    userId: session.userId,
    name: session.name,
    email: session.email,
    homeBoardId: session.homeBoardId,
    homeTitle: session.homeTitle,
  };
}

registerSiteAuthCommands({
  site: 'milanote',
  domain: DOMAIN,
  loginUrl: 'https://app.milanote.com/',
  whoamiDescription: 'Show the signed-in Milanote user and home board',
  loginDescription: 'Open Milanote and wait until the Chrome session is signed in',
  columns: ['userId', 'name', 'email', 'homeBoardId', 'homeTitle'],
  quickCheck: async (page) => {
    try {
      const session = await ensureSession(page);
      return { logged_in: Boolean(session.userId) };
    } catch (error) {
      if (error instanceof AuthRequiredError) return { logged_in: false };
      throw error;
    }
  },
  verify: identity,
});
