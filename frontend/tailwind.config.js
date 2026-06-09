/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'excel-green': '#217346',
        'excel-blue': '#2171B5',
      },
    },
  },
  plugins: [],
}
