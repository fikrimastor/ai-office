# Install AI Office: instructions for Claude

You are Claude Code, installing AI Office for the user. Most users are not technical.
**Do every step yourself.** The user only answers a few questions and says OK.

How to talk to the user:

- Short, plain sentences, in the language the user writes in. No jargon (say "the office folder", not "the working directory").
- Before you install or download anything, say what and why in one line, and ask for OK.
- When something fails, say in plain words what happened and what you will try next. Never paste a raw error without explaining it.

What AI Office is (tell the user in two lines if they ask): a manager called Hana plus 1 to 8 AI staff
that run on their own Claude account, in a folder on their computer, with a live dashboard in the browser.

## Step 1: Find Node.js (version 18 or newer)

AI Office needs Node.js. Claude Code does not include it, so check first. Use what exists before installing anything.

1. Try `node --version` (Windows: in both Bash and PowerShell if you have both).
2. If that fails or is older than 18, look in the usual places. Use the first one that exists and is 18 or newer:

   | System | Places to check |
   |---|---|
   | Windows | `%ProgramFiles%\nodejs\node.exe`, `%LOCALAPPDATA%\Programs\nodejs\node.exe`, `%USERPROFILE%\.ai-office\node\node.exe`, `%APPDATA%\nvm\v*\node.exe`, `%LOCALAPPDATA%\Volta\bin\node.exe`, `%USERPROFILE%\scoop\apps\nodejs*\current\node.exe` |
   | Mac | `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.ai-office/node/bin/node`, `~/.nvm/versions/node/*/bin/node`, `~/.volta/bin/node`, `~/.fnm` |
   | Linux | `/usr/bin/node`, `/usr/local/bin/node`, `~/.ai-office/node/bin/node`, `~/.nvm/versions/node/*/bin/node`, `~/.volta/bin/node` |

3. Found one that is not on PATH? Use its folder in the commands below (Step 3 shows how). Do not change the user's system PATH.

### No usable Node: install one

Tell the user: "AI Office needs a free program called Node.js. I can put a private copy in your home
folder. It needs no admin password and does not change anything else. OK?"

Private copy (recommended):

1. Read https://nodejs.org/dist/index.json and take the first entry where `lts` is not `false`. That is the version, for example `v24.22.3`.
2. Pick the file for this computer:
   - Windows: `node-<version>-win-x64.zip` (or `win-arm64` on ARM)
   - Mac: `node-<version>-darwin-arm64.tar.gz` (Apple chip) or `darwin-x64`
   - Linux: `node-<version>-linux-x64.tar.xz` (or `linux-arm64`)
3. Download it from `https://nodejs.org/dist/<version>/<file>`, and `SHASUMS256.txt` from the same folder.
   Check the file's SHA-256 matches its line in `SHASUMS256.txt`. If it does not match, stop and tell the user.
4. Extract it and rename the extracted folder to `.ai-office/node` in the user's home folder
   (Windows: `%USERPROFILE%\.ai-office\node`). Then check `<that folder>/node --version` works
   (Windows: `node.exe`; Mac and Linux: `bin/node`).

If the user would rather install Node for the whole computer: Windows `winget install OpenJS.NodeJS.LTS`
(Windows asks for admin), Mac `brew install node` (if Homebrew is there), otherwise the installer from https://nodejs.org.
After a system install, open a new shell before checking `node --version`.

## Step 2: Ask the setup questions, one at a time

Ask **one question per message** and wait for the answer before the next. Each question is one or two
short lines and shows its default, so the user can just say "OK". Change only what the user asks to change.

If you have a tool for multiple-choice questions (in Claude Code: AskUserQuestion), use it for every
question with choices below. Put the default first. The user can always type their own answer.
Without that tool, ask in plain text and number the choices.

1. **Company name.** "What is your company or business name?" Free text. If they skip: `My Company Sdn Bhd`.

2. **Office folder.** Suggest a folder named after the company in their home folder, for example
   `C:\Users\<name>\kedai-baju-ali` or `~/kedai-baju-ali`. Choices: that folder (default), or somewhere else.
   Avoid OneDrive and other cloud-synced folders: if they pick one, say why it is a bad idea (files sync
   while staff work, which can lock them) and suggest the home folder. If the folder already has an office, ask for another.

3. **Manager's name.** "Your manager runs the office: you talk to them, they hand work to your staff. What should we call your manager?"
   Choices: Hana (default), or their own name for the manager.

4. **Staff.** "Which staff do you want? Pick 1 to 8." Ask as two multi-select questions in the same message:

   | Main team (default: all four) | More staff (optional) |
   |---|---|
   | Aina: Customer Service | Farah: Marketing |
   | Siti: Sales | Mei Ling: Operations |
   | Nurul: Finance | Kumar: HR |
   | Ahmad: Tech | Daniel: Admin |

   They need at least 1. If they pick nobody, keep the main team.

5. **Changes.** Show the picked staff in a small table (name, role, what they do), then ask:
   "Want to rename anyone, change what they do, or add your own staff?" Choices: No, looks good (default), or Yes.
   If yes, ask in plain chat. A new staff needs a name, a role, and one line on what they do. Keep the total at 8 or fewer.
   The manager and staff should all have different names: if two match, ask to rename one.

6. **invois.online MCP.** Ask only if a picked staff works in sales or finance (role has "sales", "finance" or "account").
   "Do you send quotations or invoices? The invois.online MCP lets your sales and finance staff make real
   quotations and invoices. Free plan: 60 documents a month. Made by the team behind AI Office."
   Choices: No, maybe later (default), or Yes, connect it.
   If yes, say you will help them log in to invois.online after the office is set up.

7. **Confirm.** Show all answers in one small table and ask "Set up the office now?"
   Choices: Yes (default), or Change something. On a change, ask only about that item, then confirm again.

## Step 3: Install

1. Write the answers to a JSON file in a temporary folder, for example:

   ```json
   {
     "company": "Kedai Baju Ali Sdn Bhd",
     "folder": "C:\\Users\\Ali\\kedai-baju-ali",
     "pa": "Hana",
     "staff": [
       { "name": "Aina", "role": "Customer Service", "job": "Answer enquiries, FAQ and product info." },
       { "name": "Siti", "role": "Sales", "job": "Quotes from the price list, follow up leads, take orders." }
     ],
     "invois": false
   }
   ```

   For a default staff you may give only the name: `{ "name": "Nurul" }`.

2. Run the installer with that file. If Node is not on PATH, put its folder first on PATH for this one command:

   - Bash (also Git Bash on Windows): `PATH="<node folder>:$PATH" npx --yes github:fikrimastor/ai-office --answers "<file>"`
   - PowerShell: `$env:Path = "<node folder>;" + $env:Path; npx --yes github:fikrimastor/ai-office --answers "<file>"`

   `<node folder>` is the folder that holds `npx`: on Windows the folder with `node.exe`, on Mac and Linux its `bin` folder.
   If Node is already on PATH, just run `npx --yes github:fikrimastor/ai-office --answers "<file>"`.

3. Lines starting with `✓` went well. A line starting with `✗` says what is wrong: fix it (for example pick another
   folder) and run again. Delete the answers file when done.

## Step 4: Connect invois.online (only if they said yes)

The installer already added the invois.online MCP to the user's Claude Code (a `✓` line says so). It is
added for their whole Claude account, not only the office, so it can log in right away. Now help the user log in:

1. If the installer printed a `!` line for invois.online instead, add it yourself:
   `claude mcp add --transport http --scope user invois-online https://mcp.invois.online`
2. Tell the user: "Next I'll open the invois.online login page in your browser. Log in, or make a free
   account there (https://invois.online/?ref=ai-office), then allow access. Come back here when it says done. OK?"
3. Run `claude mcp login invois-online`. It opens the browser and waits until the user finishes, so give it
   up to 10 minutes (or run it in the background and wait for it to end).
4. It ends without an error: tell the user invois.online is connected and their sales and finance staff can use it.
5. It fails, or there is no browser: explain in plain words, then give them this to do later, once:
   run `claude`, type `/mcp`, pick `invois-online`, choose Authenticate, and log in.

## Step 5: Open the dashboard

The office folder now has a launcher that starts the dashboard with the right Node:
`Start AI Office.cmd` (Windows), `Start AI Office.command` (Mac) or `start-office.sh` (Linux).
Start it so it keeps running after this chat ends:

- Windows (works from PowerShell and from Bash): `powershell -NoProfile -Command "Start-Process -FilePath '<office folder>\Start AI Office.cmd'"`
  (opens its own window). Do not use `cmd /c start "" ...`: PowerShell drops the `""` and Git Bash rewrites `/c`, so only an empty window opens.
- Mac: `open "<office folder>/Start AI Office.command"`
- Linux: `nohup "<office folder>/start-office.sh" >/dev/null 2>&1 &`
- WSL (Linux inside Windows): same as Linux. The dashboard opens in the Windows browser, and file links in chats
  open in Windows apps. Keep the office in the Linux home folder (`~/...`), not under `/mnt/c` (much slower).
  Next time, the user starts it from a WSL terminal with `./start-office.sh` in the office folder. WSL has its
  own Claude Code login and MCP list, separate from Windows.

It opens http://localhost:4747 in the browser (or the next free port; it prints the address).

## Step 6: Tell the user what they have

In a few short lines:

- Where the office folder is, and that their manager (by the name they chose) and the staff are ready. The dashboard is open in their browser.
- Next time: double-click **Start AI Office** in the office folder. Keep its window open while using the dashboard.
- To give the manager work: open a terminal in the office folder and run `claude`. The first time, Claude Code asks
  "Do you trust this folder?": answer yes. Then just tell the manager what you need, in your own words.
- Offer to open the office folder in their file manager.
- If they said yes to invois.online: say whether it is connected (Step 4). If not, repeat the one-time steps from Step 4.5.
- Do not mention PATH or Node to the user unless they ask: the office already knows where its Node is.

Do not start any other web server. Do not change anything outside the office folder and `~/.ai-office/` (the invois.online login is kept by Claude Code itself).
