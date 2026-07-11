import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/', 'node_modules/', 'public/', 'src/sw-template.js'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			globals: {
				window: 'readonly',
				document: 'readonly',
				navigator: 'readonly',
				location: 'readonly',
				history: 'readonly',
				localStorage: 'readonly',
				sessionStorage: 'readonly',
				indexedDB: 'readonly',
				fetch: 'readonly',
				crypto: 'readonly',
				console: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				addEventListener: 'readonly',
				btoa: 'readonly',
				FormData: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				TextEncoder: 'readonly',
			},
		},
	},
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: {
				process: 'readonly',
				console: 'readonly',
				Buffer: 'readonly',
				URL: 'readonly',
			},
		},
	},
);
