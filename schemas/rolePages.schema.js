const z = require("zod");

/** The Role pages screen — services/rolePages.service.js, migration 0096. */

const roleParam = z.object({
  role: z.string().trim().min(1, "Role is required").max(64, "Role is too long"),
});

const setRolePages = z.object({
  pages: z
    .array(
      z.object({
        routePath: z.string().trim().min(1, "Page is required").max(255, "Page path is too long"),
        viewOnly: z.boolean().optional().default(false),
      }),
    )
    .max(200, "Too many pages"),
});

const setSwitch = z.object({
  enabled: z.boolean({ error: "Say whether role pages are on or off" }),
});

module.exports = { roleParam, setRolePages, setSwitch };
