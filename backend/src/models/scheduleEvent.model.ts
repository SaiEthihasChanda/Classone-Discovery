/**
 * Calendar events (Schedules): field visits by sales executives, demos (including ones customers book
 * themselves on the public booking page), calls, meetings and blocked time.
 */
import { Schema, model } from 'mongoose';

export const EVENT_TYPES = ['visit', 'demo', 'call', 'meeting', 'blocked', 'other'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_STATUSES = ['scheduled', 'on_the_way', 'checked_in', 'done', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

const pointSchema = new Schema({ at: { type: Date, required: true }, lat: Number, lng: Number, accuracy: Number, note: String }, { _id: false });

const scheduleEventSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: EVENT_TYPES, required: true, default: 'meeting' },
    start: { type: Date, required: true, index: true },
    end: { type: Date, required: true },
    allDay: Boolean,
    /** Who it is with. */
    leadId: { type: String, index: true },
    contactEmail: { type: String, lowercase: true, trim: true },
    contactName: String,
    institution: String,
    /** Where: an address (in person) or a meeting link (online). */
    mode: { type: String, enum: ['in_person', 'online'], default: 'in_person' },
    address: String,
    meetingLink: String,
    /** The sales executive it is assigned to (a user's email), told by email when assigned. */
    assignee: { type: String, lowercase: true, trim: true, index: true },
    assigneeName: String,
    notes: String,
    status: { type: String, enum: EVENT_STATUSES, default: 'scheduled', index: true },
    /** Field tracking: one GPS reading at each step, never continuous. */
    onTheWay: pointSchema,
    checkIn: pointSchema,
    checkOut: pointSchema,
    /** What came of it, written at check-out. */
    outcome: String,
    source: { type: String, enum: ['app', 'booking'], default: 'app' },
    booking: { name: String, email: String, phone: String, institution: String, message: String },
    createdBy: String,
    notifiedAssignee: String,
    reminderSentFor: String,
  },
  { collection: 'schedule_events', timestamps: true, versionKey: false },
);
scheduleEventSchema.index({ assignee: 1, start: 1 });

export const ScheduleEventModel = model('ScheduleEvent', scheduleEventSchema);
