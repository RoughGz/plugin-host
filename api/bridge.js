// Vercel serverless entry: the same stateless handler as `node server.js`.
const { handler } = require("../server.js");
module.exports = handler;
