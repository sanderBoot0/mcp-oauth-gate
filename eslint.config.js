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
            // No `x as Y` / `<Y>x` type assertions anywhere (as const is
            // exempt — it doesn't assert a different type, just narrows a
            // literal). Every place that used to cast an untyped value
            // (sqlite rows, external HTTP JSON, req.body/req.query) now
            // validates it with a zod schema instead, so the no-unsafe-*
            // rules below are meaningful again rather than firing on every
            // route.
            '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }]
        }
    },
    eslintConfigPrettier
);
