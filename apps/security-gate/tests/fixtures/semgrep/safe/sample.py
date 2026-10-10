import ast
import subprocess


def evaluate(user_input):
    return ast.literal_eval(user_input)


def launch(arguments):
    return subprocess.run(arguments, shell=False)
