/**
 * Every source the posting engine reads, in the order it books them. Each
 * lists its records and the lines each should book — see
 * services/accounting/posting.service.js for what is done with them.
 */
module.exports = [
  ...require("./orders"),
  ...require("./delivery"),
  ...require("./expenses"),
  ...require("./commissions"),
  ...require("./pfis"),
  ...require("./bankLines"),
];
