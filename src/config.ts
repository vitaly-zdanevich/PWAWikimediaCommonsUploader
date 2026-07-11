export const GITHUB_OWNER = 'vitaly-zdanevich';
export const GITHUB_REPO = 'PWAWikimediaCommonsUploader';
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const COMMONS_WIKI = 'https://commons.wikimedia.org/wiki/';
export const OAUTH_BASE = 'https://meta.wikimedia.org/w/rest.php/oauth2';
export const WDQS_URL = 'https://query.wikidata.org/sparql';

// Register at https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2
// (public / non-confidential client, callback must exactly match the deployed URL).
// Can also be set at runtime in Preferences without rebuilding.
export const DEFAULT_OAUTH_CLIENT_ID = '2260471694b45464c738bf0a5f4fe830';

export const PWA_CATEGORY = 'Uploaded by PWA from Vitaly Zdanevich';

export const CHUNK_SIZE = 4 * 1024 * 1024;

export const APP_VERSION = __APP_VERSION__;

export const UPLOAD_COMMENT = `Uploaded by PWA from Vitaly Zdanevich (v${APP_VERSION})`;

// Extensions Wikimedia Commons rejects: routed to the conversion endpoint (AWS Lambda).
export const CONVERT_EXTENSIONS = [
	'heic', 'heif', 'mp4', 'mov', 'm4v', '3gp', 'avi', 'mkv', 'mts', 'm2ts', 'wmv',
];
