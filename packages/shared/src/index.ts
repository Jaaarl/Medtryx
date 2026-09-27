import { z } from "zod";

export const userRoleSchema = z.enum(["owner", "cashier"]);

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.email(),
  role: userRoleSchema,
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const createUserSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(12).max(128),
    role: userRoleSchema,
  })
  .strict();

export type UserRole = z.infer<typeof userRoleSchema>;
export type User = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
