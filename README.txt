This is a static version of the options trading workflow.

Why this version exists:
- It avoids npm and Vite entirely.
- Vercel can host it as a static site with no dependency installation.

How to use it on GitHub/Vercel:
1. Delete the old files in your GitHub repository.
2. Upload these files instead:
   - index.html
   - style.css
   - app.js
   - vercel.json
   - README.txt
3. In Vercel, trigger a fresh deployment from the latest commit.
4. Because there is no package.json, Vercel should treat it as a static site.

Notes:
- Sessions are stored in the browser using local storage.
- Rationale is still submitted separately on SurreyLearn.
- The UI includes saved sessions, best-four selection, and the two-scenario rule.
