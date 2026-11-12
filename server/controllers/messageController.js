// Message Controller for Partnership Coordination
import { query, get, run } from '../database/database.js';

// Helper to generate a contextual Virtual Study Companion encouragement/guidance
function generateCompanionResponse(userText) {
  const lower = userText.toLowerCase();

  if (lower.includes('alhamdulillah') || lower.includes('finished') || lower.includes('completed') || lower.includes('done')) {
    return "MashaAllah tabarakAllah! May Allah accept every single letter you recited and make the Quran a luminous guide and intercessor for you on the Day of Judgment. Keep building your daily streak! 🌟";
  }

  if (lower.includes('test') || lower.includes('quiz') || lower.includes('check')) {
    return "Ready to test your retention! 📖 Here is a tip: Recite the first 5 verses without looking at the Mushaf. If you hesitate on an ending, pause and recall the thematic flow before peeking. Which specific Surah and Ayah range would you like to review?";
  }

  if (lower.includes('mutashabihat') || lower.includes('similar')) {
    return "SubhanAllah, mutashabihat require gentle patience! Pro-tip: Write the differing verses side-by-side in your notebook and underline the unique word (e.g., 'ذَٰلِكَ' vs 'تِلْكَ', or 'سَوَاءٌ عَلَيْهِمْ'). Reviewing right after Fajr often solidifies these nuances best.";
  }

  if (lower.includes('plan') || lower.includes('schedule') || lower.includes('routine')) {
    return "A wonderful daily rhythm for Quran learners: 1) Recite 1 new page with tajweed before starting; 2) Repeat the new page 15-20 times; 3) Revise the last 5 pages from memory (Muraja'ah); 4) Conclude with your daily check-in log! Would you like to schedule a dedicated session?";
  }

  if (lower.includes('partner') || lower.includes('mate') || lower.includes('pair')) {
    return "Having a 1-to-1 Quran Mate doubles consistency! While you practice here, be sure to check the 'Discover' tab — sisters are browsing for study partners at your stage right now. You can send a request with one click!";
  }

  return "Assalamu alaikum! Recorded your study note in your personal Quran Journal. Remember the Prophet ﷺ said: 'The best among you are those who learn the Quran and teach it.' Continue your noble effort, and take your time perfecting the Makharij! 🌙";
}

export async function getMessages(req, res) {
  try {
    const currentUserId = req.user.id;
    const isSolo = req.params.id === 'solo' || isNaN(parseInt(req.params.id, 10));

    if (isSolo) {
      const notes = await query(
        `SELECT id, user_id as sender_id, sender_name, sender_type, text, created_at
         FROM solo_study_notes
         WHERE user_id = ?
         ORDER BY created_at ASC`,
        [currentUserId]
      );

      if (notes.length === 0) {
        // Provide starter welcoming message
        const welcomeMsg = {
          id: 0,
          sender_id: 0,
          sender_name: 'Quran Mate Companion',
          sender_avatar: '#047857',
          text: 'Assalamu alaikum wa rahmatullah! 🌸 Welcome to your Virtual Quran Study Companion & Journal.\n\nEven before pairing with a 1-to-1 human partner, you can use this sacred space to record recitation reflections, note mutashabihat, ask for revision routines, or practice recitation prompts. What are you memorizing today?',
          created_at: new Date().toISOString()
        };
        return res.json({ messages: [welcomeMsg] });
      }

      const formatted = notes.map((n) => ({
        id: n.id,
        sender_id: n.sender_type === 'companion' ? 0 : n.sender_id,
        sender_name: n.sender_type === 'companion' ? 'Quran Mate Companion' : (n.sender_name || 'You'),
        sender_avatar: n.sender_type === 'companion' ? '#047857' : null,
        text: n.text,
        created_at: n.created_at
      }));

      return res.json({ messages: formatted });
    }

    const partnershipId = parseInt(req.params.id, 10);

    // Verify caller belongs to this partnership
    const partnership = await get(
      `SELECT id, user_a_id, user_b_id FROM partnerships
       WHERE id = ? AND (user_a_id = ? OR user_b_id = ?)`,
      [partnershipId, currentUserId, currentUserId]
    );

    if (!partnership) {
      return res.status(403).json({ error: 'Access denied: not a partner in this conversation' });
    }

    const messages = await query(
      `SELECT m.id, m.partnership_id, m.sender_id, m.text, m.created_at,
              u.name as sender_name, u.avatar_color as sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.partnership_id = ?
       ORDER BY m.created_at ASC`,
      [partnershipId]
    );

    return res.json({ messages });
  } catch (err) {
    console.error('getMessages error:', err);
    return res.status(500).json({ error: 'Failed to retrieve messages' });
  }
}

export async function sendMessage(req, res) {
  try {
    const currentUserId = req.user.id;
    const { text } = req.body;
    const isSolo = req.params.id === 'solo' || isNaN(parseInt(req.params.id, 10));

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Message text cannot be empty' });
    }

    const sender = await get('SELECT name, avatar_color FROM users WHERE id = ?', [currentUserId]);

    if (isSolo) {
      // 1. Save user's study note
      const userRes = await run(
        `INSERT INTO solo_study_notes (user_id, sender_type, sender_name, text)
         VALUES (?, 'user', ?, ?)`,
        [currentUserId, sender?.name || 'You', text.trim()]
      );

      const userMessage = {
        id: userRes.lastInsertRowid,
        sender_id: currentUserId,
        sender_name: sender?.name || 'You',
        sender_avatar: sender?.avatar_color || '#047857',
        text: text.trim(),
        created_at: new Date().toISOString()
      };

      // 2. Generate and save companion response
      const companionReply = generateCompanionResponse(text);
      const compRes = await run(
        `INSERT INTO solo_study_notes (user_id, sender_type, sender_name, text)
         VALUES (?, 'companion', 'Quran Mate Companion', ?)`,
        [currentUserId, companionReply]
      );

      const companionMessage = {
        id: compRes.lastInsertRowid,
        sender_id: 0,
        sender_name: 'Quran Mate Companion',
        sender_avatar: '#047857',
        text: companionReply,
        created_at: new Date().toISOString()
      };

      return res.status(201).json({
        message: 'Study note recorded',
        data: userMessage,
        reply: companionMessage
      });
    }

    const partnershipId = parseInt(req.params.id, 10);

    // Verify caller belongs to this partnership
    const partnership = await get(
      `SELECT id FROM partnerships
       WHERE id = ? AND (user_a_id = ? OR user_b_id = ?) AND status = 'active'`,
      [partnershipId, currentUserId, currentUserId]
    );

    if (!partnership) {
      return res.status(403).json({ error: 'Access denied: active partnership required to send messages' });
    }

    const result = await run(
      `INSERT INTO messages (partnership_id, sender_id, text)
       VALUES (?, ?, ?)`,
      [partnershipId, currentUserId, text.trim()]
    );

    const newMessage = {
      id: result.lastInsertRowid,
      partnership_id: partnershipId,
      sender_id: currentUserId,
      sender_name: sender.name,
      sender_avatar: sender.avatar_color,
      text: text.trim(),
      created_at: new Date().toISOString()
    };

    return res.status(201).json({ message: 'Message sent', data: newMessage });
  } catch (err) {
    console.error('sendMessage error:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
}
