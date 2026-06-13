const fs = require("node:fs");
const path = require("node:path");

const settingsPath = path.join(__dirname, "..", "src", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

const collator = new Intl.Collator("en", {
  numeric: false,
  sensitivity: "base",
});

function normalizeList(values, pathName) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${pathName} must be an array`);
  }

  const uniqueValues = [ ...new Set(values) ];
  uniqueValues.sort((left, right) => {
    const leftWildcard = left.includes("*");
    const rightWildcard = right.includes("*");
    if (leftWildcard !== rightWildcard) {
      return leftWildcard ? -1 : 1;
    }

    const result = collator.compare(left, right);
    if (result !== 0) {
      return result;
    }

    return left.localeCompare(right);
  });

  values.splice(0, values.length, ...uniqueValues);
}

normalizeList(settings.github.owners, "github.owners");
normalizeList(settings.github.repositories, "github.repositories");
normalizeList(settings.docker.repositories, "docker.repositories");

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
