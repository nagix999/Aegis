/** Python UI injects 8-python; source tests and legacy Sites keep version 2. */
export const PYTHON_ENGINE_VERSION = '8-python';
declare const __AEGIS_ENGINE_VERSION__: string;
export const ENGINE_VERSION = typeof __AEGIS_ENGINE_VERSION__ === 'string' ? __AEGIS_ENGINE_VERSION__ : '2';
