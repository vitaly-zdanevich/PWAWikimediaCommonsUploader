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

// Override in Preferences when deploying the converter under another tool name.
export const DEFAULT_CONVERSION_URL = 'https://pwa-commons-uploader.toolforge.org/convert';

export const PWA_CATEGORY = 'Uploaded by PWA from Vitaly Zdanevich';

// hidden maintenance category added by Namify, so coordinate-named files stay findable
export const NAMIFY_CATEGORY = 'Files with coordinate-based names uploaded by PWA';

// Every chunk consumes one hit of the Commons upload rate limit
// (380 hits / 72 min for regular users), so chunks are large.
export const CHUNK_SIZE = 16 * 1024 * 1024;

export const APP_VERSION = __APP_VERSION__;

// summaries render wikilinks but never external URLs, so the clickable part
// points to our section on Commons:Upload tools, which links to the app
export const UPLOAD_COMMENT = `[[Commons:Upload tools#Progressive Web Apps|Uploaded by PWA from Vitaly Zdanevich]] (v${APP_VERSION})`;

// Image/video extensions Wikimedia Commons rejects: routed to the Toolforge converter.
export const CONVERT_EXTENSIONS = [
	'arw', 'avif', 'bmp', 'cr2', 'cr3', 'dng', 'heic', 'heif', 'jxl', 'nef', 'orf', 'pbm', 'pef',
	'pgm', 'ppm', 'psd', 'raf', 'rw2', 'tga',
	'3g2', '3gp', 'asf', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mts', 'mxf', 'qt',
	'rm', 'rmvb', 'ts', 'vob', 'wmv',
];
