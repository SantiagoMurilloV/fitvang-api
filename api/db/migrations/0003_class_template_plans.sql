CREATE TABLE IF NOT EXISTS "class_template_plans" (
  "template_id" uuid NOT NULL REFERENCES "class_templates"("id") ON DELETE CASCADE,
  "plan_type_id" uuid NOT NULL REFERENCES "plan_types"("id") ON DELETE CASCADE,
  CONSTRAINT "class_template_plans_pkey" PRIMARY KEY ("template_id", "plan_type_id")
);
