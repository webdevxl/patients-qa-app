-- CreateTable
CREATE TABLE "patient" (
    "id" TEXT NOT NULL,
    "name_first" TEXT,
    "name_last" TEXT,
    "dob" DATE,
    "gender" TEXT,
    "ethnicity_description" TEXT,
    "legal_mailing_address" JSONB,
    "unit_description" TEXT,
    "floor_description" TEXT,
    "room_description" TEXT,
    "bed_description" TEXT,
    "status" TEXT,
    "admission_time" TIMESTAMPTZ,
    "discharge_time" TIMESTAMPTZ,
    "death_time" TIMESTAMPTZ,
    "email" TEXT,
    "phone" TEXT,
    "outpatient" BOOLEAN,
    "rev_by" TEXT,
    "rev_time" TIMESTAMPTZ,
    "on_leave" BOOLEAN,
    "group" TEXT NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergy" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "allergen" TEXT,
    "category" TEXT,
    "clinical_status" TEXT,
    "created_by" TEXT,
    "created_time" TIMESTAMPTZ,
    "onset_date" DATE,
    "reaction_note" TEXT,
    "reaction_type" TEXT,
    "reaction_sub_type" TEXT,
    "resolved_date" DATE,
    "rev_by" TEXT,
    "rev_time" TIMESTAMPTZ,
    "severity" TEXT,
    "type" TEXT,

    CONSTRAINT "patient_allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_condition" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "clinical_status" TEXT,
    "created_by" TEXT,
    "created_time" TIMESTAMPTZ,
    "icd_10_code" TEXT,
    "icd_10_description" TEXT,
    "onset_date" DATE,
    "is_primary_diagnosis" BOOLEAN,
    "resolved_date" DATE,
    "rev_by" TEXT,
    "rev_time" TIMESTAMPTZ,

    CONSTRAINT "patient_condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_medication" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "created_time" TIMESTAMPTZ,
    "description" TEXT,
    "directions" TEXT,
    "generic_name" TEXT,
    "narcotic" BOOLEAN,
    "order_time" TIMESTAMPTZ,
    "rev_time" TIMESTAMPTZ,
    "rx_norm_id" TEXT,
    "start_time" DATE,
    "status" TEXT,
    "strength" TEXT,
    "strength_unit" TEXT,

    CONSTRAINT "patient_medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_observation" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "method" TEXT,
    "recorded_by" TEXT,
    "recorded_time" TIMESTAMPTZ,
    "data" JSONB,

    CONSTRAINT "patient_observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_group_idx" ON "patient"("group");

-- CreateIndex
CREATE INDEX "patient_allergy_patient_id_idx" ON "patient_allergy"("patient_id");

-- CreateIndex
CREATE INDEX "patient_condition_patient_id_idx" ON "patient_condition"("patient_id");

-- CreateIndex
CREATE INDEX "patient_medication_patient_id_idx" ON "patient_medication"("patient_id");

-- CreateIndex
CREATE INDEX "patient_observation_patient_id_idx" ON "patient_observation"("patient_id");

-- AddForeignKey
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_medication" ADD CONSTRAINT "patient_medication_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_observation" ADD CONSTRAINT "patient_observation_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
