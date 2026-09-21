import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
            // req.body is inherently `any` (Express doesn't type it), and every
            // route already validates shape with `typeof` checks before use —
            // these rules would otherwise flag that pattern on every route.
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off'
        }
    },
    eslintConfigPrettier
);
