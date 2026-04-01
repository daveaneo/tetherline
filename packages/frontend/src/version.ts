declare const __BUILD_VERSION__: string;
export const VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
