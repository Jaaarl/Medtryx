import { z } from "zod";

export const userRoleSchema = z.enum(["owner", "cashier"]);

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.email(),
  username: z.string().nullable(),
  role: userRoleSchema,
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const createUserSchema = z
  .object({
    email: z.email().max(254),
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    password: z.string().min(8).max(128),
    role: userRoleSchema,
  })
  .strict();

export type UserRole = z.infer<typeof userRoleSchema>;
export type User = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
