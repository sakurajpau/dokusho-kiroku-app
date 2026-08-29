DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = 'kakunin_you_2029');
DELETE FROM users WHERE username = 'kakunin_you_2029';
