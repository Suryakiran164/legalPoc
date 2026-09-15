/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1B2340',        // deep navy - headers, primary text
        slate: {
          950: '#0F1424',
        },
        paper: '#F6F5F1',      // warm off-white background
        line: '#DEDCD3',       // hairline borders
        brass: '#B08948',      // accent - used sparingly (primary actions)
        signal: {
          ok: '#2F6F4E',
          issue: '#B0651F',
          missing: '#A6342A',
          verify: '#8A6D00',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
