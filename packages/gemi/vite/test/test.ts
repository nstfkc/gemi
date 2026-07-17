import { customRequestParser } from "../../bun/customRequestParser";

const orgFile = await Bun.file(__dirname + "/ApiRouter.ts").text();

console.log(await customRequestParser(orgFile));
