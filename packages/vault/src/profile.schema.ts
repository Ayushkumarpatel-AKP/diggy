/**
 * @diggy/vault — profile schema.
 *
 * A zod schema mirroring `@diggy/shared`'s `Profile`, with sensible defaults so a
 * partially-populated (or empty) object always parses into a complete profile.
 *
 * `parseProfile` / `serializeProfile` are the canonical (de)serialisation helpers.
 * `stripSecrets` removes the `secrets` section for safe, PII-redacted consumption.
 */
import { z } from 'zod';
import type { Profile } from '@diggy/shared';

export const LinkSetSchema = z.object({
  github: z.string().optional(),
  linkedin: z.string().optional(),
  portfolio: z.string().optional(),
  leetcode: z.string().optional(),
  other: z.array(z.string()).optional(),
});

export const IdentitySchema = z.object({
  fullName: z.string().default(''),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  links: LinkSetSchema.default({}),
});

export const EducationSchema = z.object({
  institution: z.string().default(''),
  degree: z.string().optional(),
  field: z.string().optional(),
  startYear: z.string().optional(),
  endYear: z.string().optional(),
  grade: z.string().optional(),
});

export const ExperienceSchema = z.object({
  company: z.string().default(''),
  role: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  current: z.boolean().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
});

export const ProjectSchema = z.object({
  name: z.string().default(''),
  description: z.string().optional(),
  url: z.string().optional(),
  tech: z.array(z.string()).optional(),
});

export const DocumentRefSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  mime: z.string().default(''),
  size: z.number().optional(),
  dataUrl: z.string().optional(),
});

export const PreferencesSchema = z.object({
  roles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  workType: z.enum(['remote', 'hybrid', 'onsite', 'any']).optional(),
  noticePeriod: z.string().optional(),
  expectedCtc: z.string().optional(),
});

export const CustomAnswerSchema = z.object({
  pattern: z.string().default(''),
  answer: z.string().default(''),
});

/**
 * The sensitive section. Kept as its own schema so it can be validated/stripped
 * independently. Values here must NEVER be auto-filled without explicit confirmation.
 */
export const SecretsSchema = z.object({
  govIds: z.record(z.string()).optional(),
  pan: z.string().optional(),
  bank: z.record(z.string()).optional(),
});

export const ProfileSchema = z.object({
  identity: IdentitySchema.default({}),
  education: z.array(EducationSchema).default([]),
  experience: z.array(ExperienceSchema).default([]),
  skills: z.array(z.string()).default([]),
  projects: z.array(ProjectSchema).default([]),
  certifications: z.array(z.string()).optional(),
  documents: z.record(DocumentRefSchema).default({}),
  customAnswers: z.array(CustomAnswerSchema).default([]),
  preferences: PreferencesSchema.default({}),
  secrets: SecretsSchema.default({}),
});

/** Raw input type accepted by `ProfileSchema`. */
export type ProfileInput = z.input<typeof ProfileSchema>;
/** Parsed/normalised output type of `ProfileSchema`. */
export type ProfileParsed = z.output<typeof ProfileSchema>;
/** A profile with the `secrets` section removed. */
export type ProfileWithoutSecrets = Omit<Profile, 'secrets'>;

/** Parse + validate into a complete `Profile` (fills defaults for missing sections). */
export function parseProfile(input: unknown): Profile {
  return ProfileSchema.parse(input);
}

/** Non-throwing parse. */
export function safeParseProfile(input: unknown) {
  return ProfileSchema.safeParse(input);
}

/** Validate then JSON-serialize a profile for persistence/transport. */
export function serializeProfile(profile: Profile): string {
  return JSON.stringify(ProfileSchema.parse(profile));
}

/** Parse a JSON string produced by `serializeProfile` (or any compatible JSON). */
export function parseSerializedProfile(json: string): Profile {
  return parseProfile(JSON.parse(json));
}

/** A complete, empty profile (all sections present, all empty). */
export function emptyProfile(): Profile {
  return ProfileSchema.parse({});
}

/**
 * Returns a copy of the profile with the `secrets` section removed.
 * The input is not mutated.
 */
export function stripSecrets(profile: Profile): ProfileWithoutSecrets {
  const { secrets: _secrets, ...rest } = profile;
  void _secrets;
  return rest;
}
