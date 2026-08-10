import { defineConfig } from 'vite'

export default defineConfig({
  base: '/frosted-glass/',
  build: {
    target: 'es2022',
  },
  assetsInclude: ['**/*.glsl'],
})
