import tseslint from 'typescript-eslint';
import paths from 'eslint-plugin-paths';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { paths },
    rules: {
      // only care about path aliases — disable everything else
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'paths/alias': 'error',
    },
  },
];
