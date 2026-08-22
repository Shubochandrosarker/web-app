/**
 * The complete schema.
 *
 * Modules are split by domain, but they are one Postgres schema and one
 * migration history — cross-module foreign keys (a lead referencing a service,
 * a document referencing a contact) are the point of using a relational
 * database, and splitting them into separate databases now would trade real
 * integrity for imagined future flexibility.
 */
export * from './enums.ts';
export * from './identity.ts';
export * from './business.ts';
export * from './content.ts';
export * from './seo.ts';
export * from './crm.ts';
export * from './forms.ts';
export * from './scheduling.ts';
export * from './orders.ts';
export * from './messaging.ts';
export * from './automation.ts';
export * from './analytics.ts';
