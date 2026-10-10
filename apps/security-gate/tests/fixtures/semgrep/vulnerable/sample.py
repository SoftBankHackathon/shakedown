import subprocess


def evaluate(user_input):
    return eval(user_input)


def launch(user_input):
    return subprocess.run(user_input, shell=True)
