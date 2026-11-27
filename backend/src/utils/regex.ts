/** Escapes text for use inside a RegExp (or a MongoDB $regex), so it matches literally. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
