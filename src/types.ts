export type LicenseId = 'cc-by-4.0' | 'cc-by-sa-4.0' | 'cc0';

export interface Account {
	username: string;
	accessToken: string;
	refreshToken: string;
	/** epoch ms when the access token expires */
	expiresAt: number;
}

export type EntryStatus = 'new' | 'pending' | 'uploading' | 'error' | 'done';

export interface EntryLink {
	text: string;
	href: string;
}

export interface Entry {
	id: string;
	seq: number;
	/** null after a successful upload (blob freed, metadata kept) */
	file: File | null;
	origName: string;
	size: number;
	lastModified: number;

	customName: string;
	description: string;
	categories: string[];
	/** '' means "use default license" */
	license: LicenseId | '';

	// snapshot taken when the upload starts, so it survives restarts unchanged
	username: string;
	prefix: string;
	globalCats: string[];

	status: EntryStatus;
	offset: number;
	filekey?: string;
	finalName?: string;
	error?: string;
	errorLinks?: EntryLink[];
	progressText?: string;
	pageUrl?: string;
	fileUrl?: string;
	viaLambda: boolean;
}
