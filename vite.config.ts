import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	server: {
		allowedHosts: true,
	},
	test: {
		environment: 'jsdom',
		setupFiles: ['./vitest.setup.ts'],
	},
} as any);
