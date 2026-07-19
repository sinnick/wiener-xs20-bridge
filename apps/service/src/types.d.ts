// Bun permite importar archivos como texto crudo con:
//   import sql from "./schema.sql" with { type: "text" };
// TypeScript no conoce ese loader por defecto, asi que lo declaramos.
declare module "*.sql" {
  const content: string;
  export default content;
}
