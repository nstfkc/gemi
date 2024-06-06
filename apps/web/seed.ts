import { prisma } from "./app/database/prisma";

// await prisma.product
//   .createMany({
//     data: [
//       {
//         name: "Gaming chair - SM",
//         description: "Gaming chair 1",
//         image: "",
//         sku: "0001",
//         organizationId: "clx1i33ys0000bue62cdk4j32",
//       },
//       {
//         name: "Gaming chair - MD",
//         description: "Gaming chair 1",
//         image: "",
//         sku: "0002",

//         organizationId: "clx1i33ys0000bue62cdk4j32",
//       },
//       {
//         name: "Gaming chair - Xl",
//         description: "Gaming chair 1",
//         image: "",
//         sku: "0003",
//         organizationId: "clx1i33ys0000bue62cdk4j32",
//       },
//     ],
//   })
//   .then(console.log);

// await prisma.host
//   .create({
//     data: {
//       name: "Jeremy",
//       email: "jeremy@weimannmedia.de",
//       phone: "+4917645800011",
//       description: "",
//       HostProducts: {
//         create: {
//           productId: "clx1imz590002bc0iy1q1mvf3",
//         },
//       },
//       organization: {
//         connect: {
//           id: "clx1i33ys0000bue62cdk4j32",
//         },
//       },
//       address: {
//         create: {
//           city: "Hamburg",
//           state: "Hamburg",
//           country: "Germany",
//           street: "Kellinghusenstraße 15",
//           zip: "20249",
//           lat: 53.575,
//           lng: 10.012,
//         },
//       },
//     },
//   })
//   .then(console.log);
