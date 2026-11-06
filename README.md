# SOLMATE: Lucky Solar Spins

A free, solar-themed exhibit arcade game. Five vertical reels, three horizontal paylines, five spins per player, and fictional Energy Points. All artwork, styles, and code are local. No installation, build step, network connection, or account is needed.

## Play locally

Open `index.html` in a current Chrome, Edge, Firefox, or Safari browser. For an HTTP preview, serve this folder with any static server (for example, `python -m http.server 8000` if Python is installed), then visit `http://localhost:8000`.

Tap **LET’S SPIN!**, or press Space/Enter when focus is outside a control. **How to play** explains all prizes. **New player** resets immediately, even during a spin; **Next player** starts a fresh session after five spins. Sound starts only after interaction and can be muted. Fullscreen depends on browser support. Reduced-motion preferences are respected.

## Publish on GitHub Pages

1. Commit and push `index.html`, `style.css`, `script.js`, and the entire `assets` folder to your GitHub repository.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, select **Deploy from a branch**.
3. Choose your branch and **/ (root)**, then save.
4. Open the published link shown by GitHub after deployment.

All URLs are relative, so a repository URL such as `https://username.github.io/ticap-game/` works. No workflow or build command is required.

## Rules and customization

Each new session starts with 0 points and 5 spins. For each of the three rows, identical consecutive symbols must begin at the leftmost reel. The longest match pays: 3 = 50, 4 = 150, 5 = 500. Five solar panels pay 1,000 instead of 500. Separate winning rows add together. There are no bets, money, or real-world prizes.

Edit `GAME_CONFIG` at the top of `script.js` to adjust symbol weights, the spin limit, or rewards. Each of the 15 cells is chosen independently with these weights. Outcomes are fixed before animation and the final visible cells are used for scoring. Winning spins are never forced. Six SVG illustrations live in `assets/`.

Run the rules checks with `node tests/rules.test.cjs` if Node.js is installed. Node is only for optional development checks, never needed to play or publish.

For browser integration checks, run `node tests/browser.test.cjs` with Node 22+ and Chrome installed. On other systems, set `CHROME_PATH` to your Chromium browser executable. The dependency-free test serves the game under `/ticap-game/`, checks interactions and five viewport sizes, and saves screenshots in `tests/artifacts/` (ignored by Git).
