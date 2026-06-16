document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const res = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: loginForm.username.value,
                    password: loginForm.password.value
                })
            });
            if (res.ok) window.location.href = 'dashboard.html';
            else alert('Invalid Login');
        });
    }

    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const res = await fetch('/signup', {
                method: 'POST',
                body: new FormData(signupForm)
            });
            if (res.ok) {
                alert('Success! Now log in.');
                window.location.href = 'index.html';
            } else alert('Username already exists');
        });
    }
});