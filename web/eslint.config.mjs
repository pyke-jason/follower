import tseslint from 'typescript-eslint';
import pathAlias from 'eslint-plugin-path-alias';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'path-alias': pathAlias },
    rules: {
      // only care about path aliases — disable everything else
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'path-alias/no-relative': 'error',
    },
  },
];
