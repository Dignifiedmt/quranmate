// Partnership & Check-in Controller
import { query, get, run } from '../database/database.js';

// Helper to get today's date in YYYY-MM-DD UTC/local
function getTodayDateStr() {
  return new Date().toISOString().split('T')[0];
}

// Calculate real shared streak from checkin records
async function calculateSharedStreak(partnershipId, userAId, userBId) {
  // Get all distinct checkins for this partnership grouped by date
  const checkins = await query(
    `SELECT date, user_id, completed
     FROM checkins
     WHERE partnership_id = ? AND completed = 1
     ORDER BY date DESC`,
    [partnershipId]
  );

  if (!checkins || checkins.length === 0) return 0;

  // Group by date: date -> Set of user_ids who completed
  const dateMap = {};
  for (const c of checkins) {
    if (!dateMap[c.date]) {
      dateMap[c.date] = new Set();
    }
    dateMap[c.date].add(c.user_id);
  }

  const today = new Date();
  let current = new Date(today);
  let streak = 0;

  // Check if today has check-ins
  const todayStr = current.toISOString().split('T')[0];
  const todayCompleted = dateMap[todayStr] && dateMap[todayStr].size > 0;

  // If today isn't completed yet, start testing from yesterday so active streak is not prematurely broken
  if (!todayCompleted) {
    current.setDate(current.getDate() - 1);
  }

  // Iterate backwards day by day
  for (let i = 0; i < 365; i++) {
    const dStr = current.toISOString().split('T')[0];
    const completedSet = dateMap[dStr];

    // If at least one partner completed or both completed
    // In our shared consistency model, if the partners studied on that day, it counts!
    if (completedSet && completedSet.size > 0) {
      streak++;
      current.setDate(current.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

// Calculate user study streak for solo or paired learners
async function calculateUserStreak(userId) {
  const datesResult = await query(
    `SELECT DISTINCT date FROM daily_tracker_logs 
     WHERE user_id = ? AND completed = 1
     UNION
     SELECT DISTINCT date FROM checkins
     WHERE user_id = ? AND completed = 1
     ORDER BY date DESC`,
    [userId, userId]
  );

  if (!datesResult || datesResult.length === 0) return 0;

  const dateSet = new Set(datesResult.map((r) => r.date));
  const today = new Date();
  let current = new Date(today);
  let streak = 0;

  const todayStr = current.toISOString().split('T')[0];
  const todayDone = dateSet.has(todayStr);

  if (!todayDone) {
    current.setDate(current.getDate() - 1);
  }

  for (let i = 0; i < 365; i++) {
    const dStr = current.toISOString().split('T')[0];
    if (dateSet.has(dStr)) {
      streak++;
      current.setDate(current.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

export async function getCurrentPartnership(req, res) {
  try {
    const currentUserId = req.user.id;

    // Find active partnership
    const partnership = await get(
      `SELECT id, user_a_id, user_b_id, status, created_at
       FROM partnerships
       WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'active'`,
      [currentUserId, currentUserId]
    );

    if (!partnership) {
      const currentUser = await get(
        `SELECT id, name, email, bio, memorization_stage, goal, avatar_color FROM users WHERE id = ?`,
        [currentUserId]
      );
      const todayStr = getTodayDateStr();
      const todayLog = await get(
        `SELECT id, activity_type, portion_covered, pages_count, duration_minutes, notes, created_at
         FROM daily_tracker_logs
         WHERE user_id = ? AND date = ?
         ORDER BY id DESC LIMIT 1`,
        [currentUserId, todayStr]
      );
      const userStreak = await calculateUserStreak(currentUserId);

      // Fetch recommended partners matching or near user's stage
      const recommendedPartners = await query(
        `SELECT u.id, u.name, u.bio, u.memorization_stage, u.goal, u.avatar_color,
                (SELECT COUNT(*) FROM availability a WHERE a.user_id = u.id) as availability_count
         FROM users u
         WHERE u.id != ?
         ORDER BY (u.memorization_stage = ?) DESC, u.id ASC
         LIMIT 4`,
        [currentUserId, currentUser?.memorization_stage || '']
      );

      for (const p of recommendedPartners) {
        const slots = await query(
          `SELECT day, start_time, end_time FROM availability WHERE user_id = ? ORDER BY id ASC`,
          [p.id]
        );
        p.availability = slots;
      }

      return res.json({
        partnership: null,
        soloMode: {
          active: true,
          user: currentUser,
          streak: userStreak,
          today: {
            date: todayStr,
            completed: !!todayLog,
            portion: todayLog?.portion_covered || '',
            activityType: todayLog?.activity_type || 'hifz',
            notes: todayLog?.notes || '',
            durationMinutes: todayLog?.duration_minutes || 25,
            logId: todayLog?.id || null,
          },
          recommendedPartners,
        },
      });
    }

    const partnerId = partnership.user_a_id === currentUserId ? partnership.user_b_id : partnership.user_a_id;

    // Fetch user details for both
    const currentUser = await get(
      `SELECT id, name, email, bio, memorization_stage, goal, avatar_color FROM users WHERE id = ?`,
      [currentUserId]
    );
    const partnerUser = await get(
      `SELECT id, name, email, bio, memorization_stage, goal, avatar_color FROM users WHERE id = ?`,
      [partnerId]
    );

    // Fetch partner availability
    const partnerAvailability = await query(
      `SELECT day, start_time, end_time FROM availability WHERE user_id = ? ORDER BY id ASC`,
      [partnerId]
    );

    const todayStr = getTodayDateStr();

    // Check today's check-in for current user
    const myTodayCheckin = await get(
      `SELECT id, completed, notes, created_at FROM checkins
       WHERE partnership_id = ? AND user_id = ? AND date = ?`,
      [partnership.id, currentUserId, todayStr]
    );

    // Check today's check-in for partner
    const partnerTodayCheckin = await get(
      `SELECT id, completed, notes, created_at FROM checkins
       WHERE partnership_id = ? AND user_id = ? AND date = ?`,
      [partnership.id, partnerId, todayStr]
    );

    // Calculate real shared streak
    const sharedStreak = await calculateSharedStreak(partnership.id, partnership.user_a_id, partnership.user_b_id);

    // Fetch last 7 days checkin history for progress graph
    const recentCheckins = await query(
      `SELECT date, user_id, completed, notes
       FROM checkins
       WHERE partnership_id = ?
       ORDER BY date DESC LIMIT 30`,
      [partnership.id]
    );

    return res.json({
      partnership: {
        id: partnership.id,
        status: partnership.status,
        created_at: partnership.created_at,
        me: currentUser,
        partner: {
          ...partnerUser,
          availability: partnerAvailability
        },
        today: {
          date: todayStr,
          myCheckin: myTodayCheckin ? { completed: myTodayCheckin.completed === 1, notes: myTodayCheckin.notes } : { completed: false, notes: '' },
          partnerCheckin: partnerTodayCheckin ? { completed: partnerTodayCheckin.completed === 1, notes: partnerTodayCheckin.notes } : { completed: false, notes: '' },
          bothCompletedToday: (myTodayCheckin?.completed === 1) && (partnerTodayCheckin?.completed === 1)
        },
        sharedStreak,
        recentCheckins
      }
    });
  } catch (err) {
    console.error('getCurrentPartnership error:', err);
    return res.status(500).json({ error: 'Failed to load active partnership' });
  }
}

export async function toggleCheckin(req, res) {
  try {
    const currentUserId = req.user.id;
    const partnershipId = parseInt(req.params.id, 10);
    const { notes } = req.body;
    const todayStr = getTodayDateStr();

    // Verify partnership belongs to user
    const partnership = await get(
      `SELECT id, user_a_id, user_b_id FROM partnerships
       WHERE id = ? AND (user_a_id = ? OR user_b_id = ?) AND status = 'active'`,
      [partnershipId, currentUserId, currentUserId]
    );

    if (!partnership) {
      return res.status(404).json({ error: 'Active partnership not found' });
    }

    // Check existing check-in for today
    const existing = await get(
      `SELECT id, completed FROM checkins WHERE partnership_id = ? AND user_id = ? AND date = ?`,
      [partnershipId, currentUserId, todayStr]
    );

    let newStatus = 1;
    if (existing) {
      newStatus = existing.completed === 1 ? 0 : 1;
      await run(
        `UPDATE checkins SET completed = ?, notes = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newStatus, notes || '', existing.id]
      );
    } else {
      await run(
        `INSERT INTO checkins (partnership_id, user_id, date, completed, notes)
         VALUES (?, ?, ?, 1, ?)`,
        [partnershipId, currentUserId, todayStr, notes || '']
      );
    }

    const streak = await calculateSharedStreak(partnership.id, partnership.user_a_id, partnership.user_b_id);

    return res.json({
      message: newStatus === 1 ? 'Daily Quran check-in recorded! 🎉' : 'Daily check-in unchecked',
      completed: newStatus === 1,
      date: todayStr,
      streak
    });
  } catch (err) {
    console.error('toggleCheckin error:', err);
    return res.status(500).json({ error: 'Failed to update check-in' });
  }
}

export async function endPartnership(req, res) {
  try {
    const currentUserId = req.user.id;
    const partnershipId = parseInt(req.params.id, 10);

    const partnership = await get(
      `SELECT id FROM partnerships
       WHERE id = ? AND (user_a_id = ? OR user_b_id = ?) AND status = 'active'`,
      [partnershipId, currentUserId, currentUserId]
    );

    if (!partnership) {
      return res.status(404).json({ error: 'Active partnership not found' });
    }

    await run(`UPDATE partnerships SET status = 'ended' WHERE id = ?`, [partnershipId]);

    return res.json({ message: 'Partnership concluded gracefully' });
  } catch (err) {
    console.error('endPartnership error:', err);
    return res.status(500).json({ error: 'Failed to end partnership' });
  }
}

export async function soloCheckin(req, res) {
  try {
    const currentUserId = req.user.id;
    const {
      portion = 'Daily Quran Portion',
      activityType = 'hifz',
      notes = '',
      durationMinutes = 25,
      pagesCount = 1,
      ayahsCount = 5,
    } = req.body;
    const todayStr = getTodayDateStr();

    // Check if user already has a log for today
    const existing = await get(
      `SELECT id FROM daily_tracker_logs WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1`,
      [currentUserId, todayStr]
    );

    if (existing) {
      await run(
        `UPDATE daily_tracker_logs
         SET portion_covered = ?, activity_type = ?, notes = ?, duration_minutes = ?, pages_count = ?, completed = 1
         WHERE id = ?`,
        [portion, activityType, notes, durationMinutes, pagesCount, existing.id]
      );
    } else {
      await run(
        `INSERT INTO daily_tracker_logs (user_id, date, activity_type, portion_covered, pages_count, ayahs_count, duration_minutes, notes, completed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [currentUserId, todayStr, activityType, portion, pagesCount, ayahsCount, durationMinutes, notes]
      );
    }

    const streak = await calculateUserStreak(currentUserId);

    return res.json({
      message: 'Solo Quran accountability check-in recorded! 🎉 May Allah accept your recitation.',
      completed: true,
      date: todayStr,
      streak,
      portion,
      notes,
    });
  } catch (err) {
    console.error('soloCheckin error:', err);
    return res.status(500).json({ error: 'Failed to record solo check-in' });
  }
}

