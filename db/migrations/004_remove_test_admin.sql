DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = 'sakura_test_user');
DELETE FROM users WHERE username = 'sakura_test_user';
