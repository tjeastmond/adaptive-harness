import type { TaskKind } from "@adaptive-harness/core";
import type { SimulatedSolution } from "./simulated-worker.ts";

/** A small repository an eval task starts from; each run gets a fresh Git copy. */
export type Fixture = Record<string, string>;

export interface EvalVerification {
  name: string;
  command: string;
  args: string[];
}

export interface EvalTask {
  id: string;
  fixture: Fixture;
  objective: string;
  acceptanceCriteria: string[];
  /** Checks that decide whether the task was done; they run in the workspace after each worker attempt. */
  verification: EvalVerification[];
  /** The task kind a good route decision should choose. */
  expectedTaskKind: TaskKind;
  /** What the eval answers when the harness asks for clarification. */
  clarification: string;
  /** The scripted change a simulated worker applies. */
  solution: SimulatedSolution;
}

/** Runs a script with this Bun executable in the task workspace; it fails by throwing. */
function script(name: string, source: string): EvalVerification {
  return { name, command: process.execPath, args: ["-e", source] };
}

function shell(name: string, source: string): EvalVerification {
  return { name, command: "sh", args: ["-c", source] };
}

const MATH = `export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function divide(a, b) {
  return b / a;
}
`;

const MATH_FIXED = `export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`;

const mathlib: Fixture = {
  "README.md": "# mathlib\n\nSmall arithmetic helpers in `src/math.js`.\n",
  "src/math.js": MATH,
};

const GUIDE = `# Guide

## Install

Run the installer. You will recieve a confirmation email.

## Usage

Start the service. Clients recieve events over a socket.

## Support

Open an issue if you do not recieve a reply.
`;

const notes: Fixture = {
  "docs/guide.md": GUIDE,
  "CHANGELOG.md": "# Changelog\n\n## 0.1.0\n\n- Initial release.\n",
};

const APP = `{
  "name": "demo",
  "port": 3000,
  "features": {}
}
`;

const settings: Fixture = {
  "config/app.json": APP,
  "README.md": "# demo\n\nSettings live in `config/app.json`.\n",
};

const math = (check: string) => script("behavior", `const m = await import("./src/math.js");\n${check}`);
const json = (check: string) => script("config", `const c = await Bun.file("config/app.json").json();\n${check}`);

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "math-multiply",
    fixture: mathlib,
    objective: "Add a multiply(a, b) function to src/math.js.",
    acceptanceCriteria: ["src/math.js exports multiply", "multiply(3, 4) returns 12"],
    verification: [math(`if (m.multiply(3, 4) !== 12) throw new Error("multiply is wrong");`)],
    expectedTaskKind: "implementation",
    clarification: "Export multiply(a, b) from src/math.js returning a * b. Keep the other functions unchanged.",
    solution: {
      attempts: [{ files: { "src/math.js": `${MATH}\nexport function multiply(a, b) {\n  return a * b;\n}\n` } }],
    },
  },
  {
    id: "math-clamp",
    fixture: mathlib,
    objective: "Add clamp(value, min, max) to src/math.js that limits value to the inclusive range.",
    acceptanceCriteria: ["clamp(5, 0, 3) returns 3", "clamp(-1, 0, 3) returns 0", "clamp(2, 0, 3) returns 2"],
    verification: [
      math(
        `if (m.clamp(5, 0, 3) !== 3 || m.clamp(-1, 0, 3) !== 0 || m.clamp(2, 0, 3) !== 2) throw new Error("clamp is wrong");`,
      ),
    ],
    expectedTaskKind: "implementation",
    clarification: "Export clamp(value, min, max) from src/math.js; return min below the range and max above it.",
    solution: {
      attempts: [
        {
          files: {
            "src/math.js": `${MATH}\nexport function clamp(value, min, max) {\n  return Math.max(max, Math.min(min, value));\n}\n`,
          },
          summary: "Added clamp.",
        },
        {
          files: {
            "src/math.js": `${MATH}\nexport function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value));\n}\n`,
          },
          summary: "Fixed the clamp bounds.",
        },
      ],
    },
  },
  {
    id: "math-fix-divide",
    fixture: mathlib,
    objective: "divide(6, 3) returns 0.5 instead of 2. Fix divide in src/math.js and make division by zero throw.",
    acceptanceCriteria: ["divide(6, 3) returns 2", "divide(1, 0) throws a RangeError"],
    verification: [
      math(
        `if (m.divide(6, 3) !== 2) throw new Error("divide is wrong");\ntry { m.divide(1, 0); } catch (error) { if (error instanceof RangeError) process.exit(0); }\nthrow new Error("divide by zero did not throw");`,
      ),
    ],
    expectedTaskKind: "debugging",
    clarification: "divide(a, b) must return a / b and throw a RangeError when b is 0.",
    solution: { attempts: [{ files: { "src/math.js": MATH_FIXED } }] },
  },
  {
    id: "math-docs",
    fixture: mathlib,
    objective: "Document every exported function of src/math.js in README.md under an API heading.",
    acceptanceCriteria: ["README.md has an API heading", "README.md mentions add, subtract, and divide"],
    verification: [
      shell(
        "readme",
        "grep -q '^## API' README.md && grep -q 'add' README.md && grep -q 'subtract' README.md && grep -q 'divide' README.md",
      ),
    ],
    expectedTaskKind: "implementation",
    clarification: "Add a '## API' section to README.md with one bullet each for add, subtract, and divide.",
    solution: {
      attempts: [
        {
          files: {
            "README.md":
              "# mathlib\n\nSmall arithmetic helpers in `src/math.js`.\n\n## API\n\n- `add(a, b)`: returns the sum.\n- `subtract(a, b)`: returns the difference.\n- `divide(a, b)`: returns the quotient.\n",
          },
        },
      ],
    },
  },
  {
    id: "notes-changelog",
    fixture: notes,
    objective: "Add a 0.2.0 entry to CHANGELOG.md, above 0.1.0, that notes the new user guide.",
    acceptanceCriteria: ["CHANGELOG.md has a 0.2.0 heading before 0.1.0", "The 0.2.0 entry mentions the guide"],
    verification: [
      script(
        "changelog",
        `const text = await Bun.file("CHANGELOG.md").text();\nconst next = text.indexOf("## 0.2.0");\nif (next < 0 || next > text.indexOf("## 0.1.0") || !/guide/i.test(text.slice(next, text.indexOf("## 0.1.0")))) throw new Error("missing 0.2.0 entry");`,
      ),
    ],
    expectedTaskKind: "implementation",
    clarification: "Insert '## 0.2.0' with the bullet '- Added the user guide.' above the 0.1.0 section.",
    solution: {
      attempts: [
        {
          files: {
            "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- Added the user guide.\n\n## 0.1.0\n\n- Initial release.\n",
          },
        },
      ],
    },
  },
  {
    id: "notes-typo",
    fixture: notes,
    objective: "Fix every misspelling of 'receive' in docs/guide.md.",
    acceptanceCriteria: ["docs/guide.md no longer contains 'recieve'", "The guide still has three sections"],
    verification: [
      shell("spelling", "! grep -q recieve docs/guide.md && [ \"$(grep -c '^## ' docs/guide.md)\" -eq 3 ]"),
    ],
    expectedTaskKind: "debugging",
    clarification: "Replace all three occurrences of 'recieve' with 'receive'; change nothing else.",
    solution: {
      attempts: [
        { files: { "docs/guide.md": GUIDE.replace("recieve", "receive") }, summary: "Fixed a misspelling." },
        {
          files: { "docs/guide.md": GUIDE.replaceAll("recieve", "receive") },
          summary: "Fixed the remaining misspellings.",
        },
      ],
    },
  },
  {
    id: "notes-toc",
    fixture: notes,
    objective: "Add a table of contents after the title of docs/guide.md linking to each section.",
    acceptanceCriteria: ["The guide has a Contents list", "It links to #install, #usage, and #support"],
    verification: [
      shell(
        "toc",
        "grep -q '(#install)' docs/guide.md && grep -q '(#usage)' docs/guide.md && grep -q '(#support)' docs/guide.md",
      ),
    ],
    expectedTaskKind: "implementation",
    clarification: "Under the title, add 'Contents:' followed by Markdown links to #install, #usage, and #support.",
    solution: {
      attempts: [
        {
          files: {
            "docs/guide.md": GUIDE.replace(
              "# Guide\n",
              "# Guide\n\nContents:\n\n- [Install](#install)\n- [Usage](#usage)\n- [Support](#support)\n",
            ),
          },
        },
      ],
    },
  },
  {
    id: "settings-port",
    fixture: settings,
    objective: "Change the service port in config/app.json to 8080.",
    acceptanceCriteria: ["config/app.json is valid JSON", "port is 8080"],
    verification: [json(`if (c.port !== 8080) throw new Error("port is not 8080");`)],
    expectedTaskKind: "implementation",
    clarification: "Set the numeric port field in config/app.json to 8080 and leave the other fields alone.",
    solution: { attempts: [{ files: { "config/app.json": APP.replace("3000", "8080") } }] },
  },
  {
    id: "settings-flag",
    fixture: settings,
    objective: "Add a darkMode feature flag, disabled by default, to config/app.json.",
    acceptanceCriteria: ["features.darkMode is false", "The port is unchanged"],
    verification: [json(`if (c.features?.darkMode !== false || c.port !== 3000) throw new Error("flag is wrong");`)],
    expectedTaskKind: "implementation",
    clarification: 'Set "features": { "darkMode": false } in config/app.json.',
    solution: {
      attempts: [
        { files: { "config/app.json": APP.replace('"features": {}', '"features": {\n    "darkMode": false\n  }') } },
      ],
    },
  },
  {
    id: "settings-env-example",
    fixture: settings,
    objective: "Create .env.example documenting the PORT and LOG_LEVEL environment variables.",
    acceptanceCriteria: [".env.example exists", "It defines PORT and LOG_LEVEL"],
    verification: [shell("env-example", "grep -q '^PORT=' .env.example && grep -q '^LOG_LEVEL=' .env.example")],
    expectedTaskKind: "implementation",
    clarification: "Create .env.example with the lines PORT=3000 and LOG_LEVEL=info.",
    solution: { attempts: [{ files: { ".env.example": "PORT=3000\nLOG_LEVEL=info\n" } }] },
  },
];
