import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: true,
      },
    },
  },
  tseslint.configs.recommended,
)
