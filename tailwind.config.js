/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        'xl': '1rem'
      },
      transitionProperty: {
        'shadow': 'box-shadow'
      }
    }
  },
  plugins: [],
}