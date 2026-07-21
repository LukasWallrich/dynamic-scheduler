/**
 * bootstrap.js — editor-facing entry points (the Apps Script Run menu only lists
 * parameterless global functions, so the namespaced helpers are wrapped here).
 */

/** Run once after deploying the web app: installs the hourly trigger and logs the
 *  organizer's setup URL. Running it also triggers the OAuth consent screen. */
function bootstrap() {
  installTrigger();
  var url = webAppUrl();
  if (!url) {
    Logger.log('No web app URL yet — deploy the web app first (Deploy > New deployment > ' +
      'Web app), then run bootstrap() again.');
    return;
  }
  Logger.log('Setup URL (open in a browser to create a poll):\n' +
    url + '?setup=' + Security.setupToken());
}

/** Log the organizer's setup URL without touching the trigger. */
function getSetupUrl() {
  var url = webAppUrl();
  Logger.log(url ? url + '?setup=' + Security.setupToken()
                 : 'Deploy the web app first, then run this again.');
}
