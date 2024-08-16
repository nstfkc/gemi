async function main(mode = "dev") {
  const packageJSONExports = Bun.file("exports.json");
  const packageJSONExportsContent = await packageJSONExports.json();
  const packageJSON = Bun.file("package.json");
  const packageJSONContent = await packageJSON.json();
  packageJSONContent.exports = packageJSONExportsContent[mode];

  await Bun.write(
    "package.json",
    `${JSON.stringify(packageJSONContent, null, 2)}\n`,
  );
}

const args = process.argv.slice(2);

main(args[0]);
