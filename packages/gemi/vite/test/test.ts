import { customRequestParser } from "../customRequestParser";

const orgFile = await Bun.file("./TestRouter.ts").text();

console.log(await customRequestParser(orgFile));
