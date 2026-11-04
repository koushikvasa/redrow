-- Fake rows. Ana and Cho are patients and Ben is their doctor. These are demo logins, so the names don't match the roles.
insert into app_clinic.profiles (id, role, full_name) values
  (:ana, 'patient', 'Fake Patient A'), (:ben, 'doctor', 'Fake Doctor B'), (:cho, 'patient', 'Fake Patient C');
insert into app_clinic.patients (id, phone, insurance_number) values
  (:ana, '555-0100', 'FAKE-A'), (:cho, '555-0101', 'FAKE-C');
insert into app_clinic.doctors (id, specialty) values (:ben, 'Fake specialty');
insert into app_clinic.appointments (id, patient_id, doctor_id, starts_at, ends_at, reason) values
  ('30000000-0000-4000-8000-000000000001', :ana, :ben, '2030-01-01 09:00+00', '2030-01-01 09:30+00', 'Fake reason A1'),
  ('30000000-0000-4000-8000-000000000002', :ana, :ben, '2030-01-02 09:00+00', '2030-01-02 09:30+00', 'Fake reason A2'),
  ('30000000-0000-4000-8000-000000000003', :cho, :ben, '2030-01-03 09:00+00', '2030-01-03 09:30+00', 'Fake reason C1'),
  ('30000000-0000-4000-8000-000000000004', :cho, :ben, '2030-01-04 09:00+00', '2030-01-04 09:30+00', 'Fake reason C2');
insert into app_clinic.appointment_notes (appointment_id, doctor_id, note) values
  ('30000000-0000-4000-8000-000000000001', :ben, 'Fake note'),
  ('30000000-0000-4000-8000-000000000003', :ben, 'Fake note');
