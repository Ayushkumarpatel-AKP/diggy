import type { Profile } from '@diggy/shared';
import type { KdfParams } from '../src/crypto';

/** Fast Argon2id parameters so tests stay quick (production uses the defaults). */
export const CHEAP_PARAMS: KdfParams = {
  iterations: 1,
  memoryKiB: 1024,
  parallelism: 1,
  hashLength: 32,
};

export const TEST_PASSPHRASE = 'correct horse battery staple';

/** Distinctive plaintext strings that must never appear in the ciphertext blob. */
export const PII_STRINGS = [
  'Ada Lovelace',
  'ada@example.com',
  '+1-555-0100',
  'Analytical Engines Ltd',
  'ABCDE1234F',
  '1234-5678-9012',
  '000111222333',
  'Why do you want this job',
];

export function sampleProfile(): Profile {
  return {
    identity: {
      fullName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+1-555-0100',
      city: 'London',
      country: 'UK',
      links: {
        github: 'https://github.com/ada',
        linkedin: 'https://linkedin.com/in/ada',
      },
    },
    education: [
      {
        institution: 'University of London',
        degree: 'BSc',
        field: 'Mathematics',
        startYear: '1832',
        endYear: '1836',
      },
    ],
    experience: [
      {
        company: 'Analytical Engines Ltd',
        role: 'Mathematician',
        startDate: '1837',
        current: true,
        description: 'Wrote the first published algorithm',
      },
    ],
    skills: ['mathematics', 'algorithms'],
    projects: [{ name: 'Notes on the Analytical Engine', tech: ['paper'] }],
    certifications: ['First Programmer'],
    documents: {
      resume: { id: 'doc-resume', name: 'ada-resume.pdf', mime: 'application/pdf', size: 1234 },
    },
    customAnswers: [{ pattern: 'Why do you want this job', answer: 'To compute.' }],
    preferences: {
      roles: ['Mathematician'],
      locations: ['London'],
      workType: 'remote',
      noticePeriod: '2 weeks',
      expectedCtc: 'GBP 100k',
    },
    secrets: {
      govIds: { aadhaar: '1234-5678-9012' },
      pan: 'ABCDE1234F',
      bank: { account: '000111222333', ifsc: 'BANK0001' },
    },
  };
}
